import { FolderPlus, PanelTopClose, PanelTopOpen, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { palettes, type PaletteName, useThemeStore } from "@/stores/themeStore";

interface SettingsProps {
  tabsCollapsed: boolean;
  onToggleTabs: () => void;
  onNewFolderSession: () => void;
}

export function Settings({ tabsCollapsed, onToggleTabs, onNewFolderSession }: SettingsProps) {
  const { paletteName, fontSize, setPaletteName, setFontSize } = useThemeStore();
  const [open, setOpen] = useState(false);
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

  return (
    <div className="relative flex h-8 items-center gap-0.5 px-2">
      <button
        className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onNewFolderSession}
        title="Start folder-scoped session"
      >
        <FolderPlus size={13} />
      </button>
      <button
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 hover:bg-cc-surface-strong ${
          open ? "bg-cc-surface-strong/60 text-cc-accent" : "text-cc-muted hover:text-cc-foreground"
        }`}
        onClick={() => setOpen((current) => !current)}
        title="Display settings"
      >
        <Settings2 size={13} />
      </button>
      <button
        className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground"
        onClick={onToggleTabs}
        title={tabsCollapsed ? "Show tabs" : "Hide tabs"}
      >
        {tabsCollapsed ? <PanelTopOpen size={14} /> : <PanelTopClose size={14} />}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="absolute bottom-9 right-2 z-50 w-60 rounded-xl border border-cc-border bg-cc-surface/95 p-3 shadow-2xl"
        >
          <div className="mb-2 text-xs font-medium text-cc-foreground">Display</div>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-cc-muted">Theme</div>
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-cc-background/60 p-1">
                {Object.values(palettes).map((palette) => (
                  <button
                    key={palette.name}
                    className={`rounded-md px-1.5 py-1 text-[10px] ${
                      paletteName === palette.name
                        ? "bg-cc-surface-strong text-cc-foreground"
                        : "text-cc-muted hover:bg-cc-surface-strong/70 hover:text-cc-foreground"
                    }`}
                    onClick={() => setPaletteName(palette.name as PaletteName)}
                  >
                    {palette.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-cc-muted">Terminal size</div>
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
