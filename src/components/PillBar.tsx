import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  Command,
  FileText,
  Files,
  FolderPlus,
  GitBranch,
  PanelTopClose,
  PanelTopOpen,
  Pin,
  PinOff,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import { toastError, toastSuccess } from "@/stores/toastStore";
import { palettes, useThemeStore, type PalettePreference } from "@/stores/themeStore";
import type { SogoTab } from "@/types";

export type PanelName = "files" | "vault" | "skills" | "changes";

interface PillBarProps {
  tab?: SogoTab;
  activePanel: PanelName | null;
  pinned: boolean;
  tabsCollapsed: boolean;
  stoppedCount: number;
  confirmingClose: boolean;
  editorChip: { name: string; dirty: boolean } | null;
  onRequestClose: () => void;
  onConfirmClose: () => void;
  onCancelClose: () => void;
  onStop: () => void;
  onNewTab: () => void;
  onNewFolderTab: () => void;
  onTogglePanel: (panel: PanelName) => void;
  onTogglePin: () => void;
  onToggleTabs: () => void;
  onResumeAll: () => void;
  onShowEditor: () => void;
  onOpenPalette: () => void;
}

export function PillBar({
  tab,
  activePanel,
  pinned,
  tabsCollapsed,
  stoppedCount,
  confirmingClose,
  editorChip,
  onRequestClose,
  onConfirmClose,
  onCancelClose,
  onStop,
  onNewTab,
  onNewFolderTab,
  onTogglePanel,
  onTogglePin,
  onToggleTabs,
  onResumeAll,
  onShowEditor,
  onOpenPalette,
}: PillBarProps) {
  const running = !!tab && tab.started && (tab.status === "busy" || tab.status === "awaiting-input" || tab.status === "idle");

  const copyCwd = useCallback(
    (event: React.MouseEvent) => {
      if (!tab) return;
      if (event.metaKey && isTauriRuntime()) {
        void import("@tauri-apps/api/core").then(({ invoke }) => {
          void invoke("reveal_in_finder", { path: tab.cwd }).catch((error) => toastError(String(error)));
        });
        return;
      }
      void navigator.clipboard?.writeText(tab.cwd).then(() => toastSuccess("Copied working directory"));
    },
    [tab],
  );

  return (
    <div className="shrink-0 px-2 pb-2 pt-1.5">
      <div className="flex h-9 items-center gap-1 rounded-full border border-cc-border bg-cc-surface/85 pl-3 pr-1.5 shadow-[0_10px_28px_-18px_rgba(0,0,0,0.7)]">
        {tab ? (
          <>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(tab.status)}`} />
            <span className="shrink-0 text-[11px] font-medium text-cc-foreground">{statusLabel(tab.status)}</span>
            <button
              className="min-w-0 flex-1 truncate rounded px-1 text-left font-mono text-[10.5px] text-cc-muted transition-colors hover:text-cc-foreground"
              style={{ direction: "rtl" }}
              title={`${tab.cwd}\nClick to copy · ⌘-click to reveal in Finder`}
              onClick={copyCwd}
            >
              {/* rtl on the container puts the ellipsis on the left; the ltr
                  embed keeps the path characters in reading order. */}
              <span style={{ direction: "ltr", unicodeBidi: "embed" }}>{compactPath(tab.cwd)}</span>
            </button>
            {confirmingClose ? (
              <span className="flex shrink-0 items-center gap-1">
                <span className="text-[11px] text-cc-muted">Close session?</span>
                <button
                  className="flex h-6 items-center gap-1 rounded-full bg-red-500/15 px-2 text-[11px] text-red-300 hover:bg-red-500/25"
                  onClick={onConfirmClose}
                >
                  <Check size={11} />
                  Close
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-full text-cc-muted hover:text-cc-foreground"
                  onClick={onCancelClose}
                >
                  <X size={11} />
                </button>
              </span>
            ) : (
              <>
                {running ? (
                  <PillButton label="Interrupt (sends Ctrl+C)" onClick={onStop}>
                    <Square size={10} strokeWidth={2.5} />
                  </PillButton>
                ) : null}
                <PillButton label="Close session" onClick={onRequestClose}>
                  <X size={13} />
                </PillButton>
              </>
            )}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-cc-muted">No session</span>
        )}

        {editorChip ? (
          <button
            className="ml-1 flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-cc-border bg-cc-background/60 px-2 text-[10.5px] text-cc-muted transition-colors hover:text-cc-foreground"
            onClick={onShowEditor}
            title="Show editor"
          >
            <FileText size={11} />
            <span className="max-w-32 truncate">{editorChip.name}</span>
            {editorChip.dirty ? <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> : null}
          </button>
        ) : null}

        {stoppedCount > 0 ? (
          <button
            className="ml-1 flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-cc-border bg-cc-background/60 px-2 text-[10.5px] text-cc-muted transition-colors hover:text-cc-foreground"
            onClick={onResumeAll}
            title={`Resume ${stoppedCount} stopped session${stoppedCount > 1 ? "s" : ""}`}
          >
            <Play size={10} />
            Resume all
          </button>
        ) : null}

        <span className="mx-1.5 h-4 w-px shrink-0 bg-cc-border" aria-hidden />

        <PillButton label="New scratch session (⌘N)" onClick={onNewTab}>
          <Plus size={14} />
        </PillButton>
        <PillButton label="Open folder session" onClick={onNewFolderTab}>
          <FolderPlus size={13} />
        </PillButton>
        <PillButton label="Command palette (⌘K)" onClick={onOpenPalette}>
          <Command size={12} />
        </PillButton>

        <span className="mx-1.5 h-4 w-px shrink-0 bg-cc-border" aria-hidden />

        <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-cc-background/50 p-0.5">
          <SegmentButton label="Files" active={activePanel === "files"} onClick={() => onTogglePanel("files")}>
            <Files size={12} />
          </SegmentButton>
          <SegmentButton label="Changes" active={activePanel === "changes"} onClick={() => onTogglePanel("changes")}>
            <GitBranch size={12} />
          </SegmentButton>
          <SegmentButton label="Vault" active={activePanel === "vault"} onClick={() => onTogglePanel("vault")}>
            <BookOpen size={12} />
          </SegmentButton>
          <SegmentButton label="Skills" active={activePanel === "skills"} onClick={() => onTogglePanel("skills")}>
            <Sparkles size={12} />
          </SegmentButton>
        </div>

        <SettingsPopover tabsCollapsed={tabsCollapsed} onToggleTabs={onToggleTabs} />

        <PillButton label={pinned ? "Unpin" : "Pin on top"} active={pinned} onClick={onTogglePin}>
          {pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </PillButton>
      </div>
    </div>
  );
}

function PillButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${
        active
          ? "bg-cc-surface-strong/70 text-cc-accent"
          : "text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
      }`}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}

function SegmentButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`flex h-[22px] items-center gap-1 rounded-full px-2 text-[10.5px] transition-colors duration-150 ${
        active
          ? "bg-cc-surface-strong text-cc-foreground"
          : "text-cc-muted hover:text-cc-foreground"
      }`}
      onClick={onClick}
      title={`${label} panel`}
    >
      {children}
      <span className={active ? "" : "hidden xl:inline"}>{label}</span>
    </button>
  );
}

function SettingsPopover({
  tabsCollapsed,
  onToggleTabs,
}: {
  tabsCollapsed: boolean;
  onToggleTabs: () => void;
}) {
  const { preference, fontSize, setPreference, setFontSize } = useThemeStore();
  const [open, setOpen] = useState(false);
  const [hooksEnabled, setHooksEnabled] = useState<boolean | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open || !isTauriRuntime() || hooksEnabled !== null) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<boolean>("claude_hooks_status")
        .then(setHooksEnabled)
        .catch(() => setHooksEnabled(false));
    });
  }, [open, hooksEnabled]);

  const enableHooks = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<boolean>("enable_claude_hooks")
        .then(() => {
          setHooksEnabled(true);
          toastSuccess("Claude hooks enabled — applies to sessions started from now on");
        })
        .catch((error) => toastError(String(error)));
    });
  }, []);

  const themeOptions: Array<{ id: PalettePreference; label: string }> = [
    { id: "system", label: "System" },
    ...Object.values(palettes).map((palette) => ({ id: palette.name as PalettePreference, label: palette.label })),
  ];

  return (
    <div ref={popoverRef} className="relative shrink-0">
      <PillButton label="Settings" active={open} onClick={() => setOpen((current) => !current)}>
        <Settings2 size={12} />
      </PillButton>
      {open ? (
        <div className="sogo-pop absolute bottom-9 right-0 z-50 w-64 rounded-xl border border-cc-border bg-cc-surface/95 p-3 shadow-2xl">
          <div className="mb-2 text-xs font-medium text-cc-foreground">Settings</div>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-cc-muted">Theme</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-cc-background/60 p-1">
                {themeOptions.map((option) => (
                  <button
                    key={option.id}
                    className={`rounded-md px-1.5 py-1 text-[10px] ${
                      preference === option.id
                        ? "bg-cc-surface-strong text-cc-foreground"
                        : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
                    }`}
                    onClick={() => setPreference(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-cc-muted">Text size</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-cc-background/60 p-1">
                {(["small", "medium", "large"] as const).map((size) => (
                  <button
                    key={size}
                    className={`rounded-md px-1.5 py-1 text-[10px] capitalize ${
                      fontSize === size
                        ? "bg-cc-surface-strong text-cc-foreground"
                        : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
                    }`}
                    onClick={() => setFontSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-cc-muted">Notifications</div>
              {hooksEnabled ? (
                <div className="flex items-center gap-1.5 rounded-lg bg-cc-background/60 px-2 py-1.5 text-[11px] text-cc-muted">
                  <Check size={11} className="text-emerald-400" />
                  Claude hooks connected
                </div>
              ) : (
                <button
                  className="w-full rounded-lg bg-cc-background/60 px-2 py-1.5 text-left text-[11px] text-cc-muted transition-colors hover:bg-cc-surface-strong hover:text-cc-foreground"
                  onClick={enableHooks}
                  title="Adds Notification and Stop hooks to ~/.claude/settings.json so Sogo gets reliable session state"
                >
                  Enable Claude hooks for reliable status…
                </button>
              )}
            </div>
            <button
              className="flex w-full items-center gap-1.5 rounded-lg bg-cc-background/60 px-2 py-1.5 text-left text-[11px] text-cc-muted transition-colors hover:bg-cc-surface-strong hover:text-cc-foreground"
              onClick={onToggleTabs}
            >
              {tabsCollapsed ? <PanelTopOpen size={12} /> : <PanelTopClose size={12} />}
              {tabsCollapsed ? "Show tab strip" : "Hide tab strip"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function statusDotClass(status: SogoTab["status"]) {
  if (status === "idle") return "bg-emerald-400";
  if (status === "busy") return "bg-sky-400";
  if (status === "awaiting-input") return "bg-amber-300 sogo-attention-dot";
  if (status === "error") return "bg-red-400";
  return "bg-cc-muted";
}

export function statusLabel(status: SogoTab["status"]) {
  if (status === "awaiting-input") return "Needs you";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function compactPath(path: string) {
  if (!path) return "";
  const home = "/Users/";
  if (path.startsWith(home)) {
    const rest = path.slice(home.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) {
      const after = rest.slice(slashIdx + 1);
      const parts = after.split("/").filter(Boolean);
      if (parts.length <= 2) return `~/${after}`;
      return `~/…/${parts.slice(-2).join("/")}`;
    }
    return `~/${rest}`;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `/…/${parts.slice(-2).join("/")}`;
}
