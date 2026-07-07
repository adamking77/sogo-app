import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, FolderSearch, Plus, SquareX, TextCursorInput, X } from "lucide-react";

import { statusDotClass } from "@/components/PillBar";
import type { SogoTab } from "@/types";

interface TabStripProps {
  tabs: SogoTab[];
  activeTabId?: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onNewTab: () => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRevealCwd: (tab: SogoTab) => void;
  onCopySessionId: (tab: SogoTab) => void;
  onShowAllTabs: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

export function TabStrip({
  tabs,
  activeTabId,
  collapsed,
  onSelect,
  onNewTab,
  onClose,
  onCloseOthers,
  onRename,
  onMove,
  onRevealCwd,
  onCopySessionId,
  onShowAllTabs,
}: TabStripProps) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [metaHeld, setMetaHeld] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; index: number; startX: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!editingTabId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingTabId]);

  // ⌘-held: reveal the 1-9 switch badges so the shortcut teaches itself.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta") setMetaHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta") setMetaHeld(false);
    };
    const blur = () => setMetaHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const check = () => setOverflowing(scroller.scrollWidth > scroller.clientWidth + 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabs.length]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

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

  const handlePointerDown = useCallback(
    (event: React.PointerEvent, tab: SogoTab, index: number) => {
      if (event.button !== 0 || editingTabId) return;
      if ((event.target as HTMLElement).closest("button, input")) return;
      dragRef.current = { id: tab.id, index, startX: event.clientX, moved: false };
    },
    [editingTabId],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      const scroller = scrollerRef.current;
      if (!drag || !scroller) return;

      if (!drag.moved && Math.abs(event.clientX - drag.startX) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        setDraggingId(drag.id);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      }

      const pills = Array.from(scroller.querySelectorAll<HTMLElement>("[data-tab-index]"));
      const hovered = pills.findIndex((pill) => {
        const rect = pill.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right;
      });
      if (hovered >= 0 && hovered !== drag.index) {
        onMove(drag.index, hovered);
        drag.index = hovered;
      }
    },
    [onMove],
  );

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) {
      // Suppress the click-select that follows a drag release.
      window.setTimeout(() => setDraggingId(null), 0);
    } else {
      setDraggingId(null);
    }
  }, []);

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

  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : undefined;

  return (
    <div className="flex h-10 items-center gap-1 px-2" data-tauri-drag-region>
      <div
        ref={scrollerRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-3"
        style={{
          scrollbarWidth: "none",
          WebkitMaskImage: overflowing
            ? "linear-gradient(to right, black 0%, black calc(100% - 36px), transparent 100%)"
            : undefined,
          maskImage: overflowing
            ? "linear-gradient(to right, black 0%, black calc(100% - 36px), transparent 100%)"
            : undefined,
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {tabs.map((tab, index) => {
          const editing = editingTabId === tab.id;
          const needsAttention = tab.status === "awaiting-input";
          const isActive = tab.id === activeTabId;

          return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            data-tab-index={index}
            aria-selected={isActive}
            className={`group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-left text-xs transition ${
              isActive
                ? "border-cc-border bg-cc-surface-strong text-cc-foreground"
                : needsAttention
                  ? "sogo-attention-pill border-amber-300/50 bg-amber-400/10 text-cc-foreground"
                  : "border-transparent text-cc-muted hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
            } ${draggingId === tab.id ? "opacity-70" : ""}`}
            onClick={() => {
              if (dragRef.current?.moved || draggingId) return;
              onSelect(tab.id);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            onDoubleClick={() => beginRename(tab)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
            }}
            onPointerDown={(event) => handlePointerDown(event, tab, index)}
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
            {metaHeld && index < 9 ? (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cc-background/70 font-mono text-[9px] text-cc-muted">
                {index + 1}
              </span>
            ) : (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(tab.status)}`} />
            )}
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
      {overflowing ? (
        <button
          className="flex h-6 shrink-0 items-center rounded-full border border-cc-border bg-cc-surface/80 px-2 font-mono text-[10px] text-cc-muted transition-colors hover:text-cc-foreground"
          onClick={onShowAllTabs}
          title="All tabs (⌘K)"
        >
          {tabs.length}
        </button>
      ) : null}
      <button
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onNewTab}
        title="New session (⌘N)"
      >
        <Plus size={15} />
      </button>

      {contextMenu && contextTab ? (
        <div
          className="sogo-pop sogo-surface-bg fixed z-[60] w-52 rounded-xl border border-cc-border p-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <ContextItem
            icon={<TextCursorInput size={12} />}
            label="Rename"
            onClick={() => {
              setContextMenu(null);
              beginRename(contextTab);
            }}
          />
          <ContextItem
            icon={<FolderSearch size={12} />}
            label="Reveal in Finder"
            onClick={() => {
              setContextMenu(null);
              onRevealCwd(contextTab);
            }}
          />
          <ContextItem
            icon={<Copy size={12} />}
            label="Copy Claude session ID"
            onClick={() => {
              setContextMenu(null);
              onCopySessionId(contextTab);
            }}
          />
          <div className="mx-2 my-1 h-px bg-cc-border/60" />
          <ContextItem
            icon={<SquareX size={12} />}
            label="Close others"
            disabled={tabs.length < 2}
            onClick={() => {
              setContextMenu(null);
              onCloseOthers(contextTab.id);
            }}
          />
          <ContextItem
            icon={<X size={12} />}
            label="Close"
            onClick={() => {
              setContextMenu(null);
              onClose(contextTab.id);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ContextItem({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-cc-muted transition-colors duration-100 hover:bg-cc-surface-strong hover:text-cc-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-cc-muted"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}
