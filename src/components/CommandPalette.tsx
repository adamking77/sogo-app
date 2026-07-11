import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  FileText,
  FolderOpen,
  History,
  Palette,
  Pin,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";

import { isTauriRuntime } from "@/lib/runtime";
import type { ClaudeInventory, SogoTab } from "@/types";

export type PaletteMode = "all" | "files" | "search";

interface SearchHit {
  path: string;
  lineNumber: number;
  lineText: string;
}

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
  tabs: SogoTab[];
  activeTabId?: string;
  recentFolders: string[];
  sessionId?: string;
  folderChosen: boolean;
  onSelectTab: (id: string) => void;
  onNewSession: () => void;
  onOpenFolderDialog: () => void;
  onOpenRecentFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onActivateSkill: (name: string) => void;
  extraCommands: PaletteCommand[];
}

interface PaletteItem {
  id: string;
  section: string;
  label: string;
  hint?: string;
  keywords: string;
  icon: ReactNode;
  run: () => void;
}

const MAX_RESULTS = 12;

export function CommandPalette({
  open,
  mode,
  onClose,
  tabs,
  activeTabId,
  recentFolders,
  sessionId,
  folderChosen,
  onSelectTab,
  onNewSession,
  onOpenFolderDialog,
  onOpenRecentFolder,
  onOpenFile,
  onActivateSkill,
  extraCommands,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [skills, setSkills] = useState<ClaudeInventory["skills"]>([]);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, mode]);

  // Workspace file list, fetched once per open for the active session.
  useEffect(() => {
    if (!open || !isTauriRuntime() || !sessionId || !folderChosen) {
      setFiles(null);
      return;
    }

    let cancelled = false;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<string[]>("list_files_recursive", { sessionId, maxEntries: 4000 })
        .then((entries) => {
          if (!cancelled) setFiles(entries);
        })
        .catch(() => {
          if (!cancelled) setFiles([]);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [open, sessionId, folderChosen]);

  // Content search: debounce keystrokes, one backend grep per settled query.
  useEffect(() => {
    if (mode !== "search" || !open) {
      setSearchHits(null);
      setSearching(false);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2 || !isTauriRuntime() || !sessionId || !folderChosen) {
      setSearchHits(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke<SearchHit[]>("search_workspace_content", { sessionId, query: trimmed })
          .then((hits) => {
            if (cancelled) return;
            setSearchHits(hits);
            setSearching(false);
          })
          .catch(() => {
            if (cancelled) return;
            setSearchHits([]);
            setSearching(false);
          });
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, open, query, sessionId, folderChosen]);

  useEffect(() => {
    if (!open || !isTauriRuntime() || skills.length > 0) return;

    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<ClaudeInventory>("read_claude_inventory")
        .then((inventory) => setSkills(inventory.skills))
        .catch(() => undefined);
    });
  }, [open, skills.length]);

  const items = useMemo<PaletteItem[]>(() => {
    const wrapped = (run: () => void) => () => {
      onClose();
      run();
    };

    const fileItems: PaletteItem[] = (files ?? []).map((path) => ({
      id: `file:${path}`,
      section: "Files",
      label: path,
      keywords: path,
      icon: <FileText size={13} />,
      run: wrapped(() => onOpenFile(path)),
    }));

    if (mode === "files") return fileItems;

    if (mode === "search") {
      return (searchHits ?? []).map((hit): PaletteItem => ({
        id: `search:${hit.path}:${hit.lineNumber}`,
        section: "Results",
        label: hit.lineText,
        hint: `${hit.path}:${hit.lineNumber}`,
        keywords: `${hit.path} ${hit.lineText}`,
        icon: <FileText size={13} />,
        run: wrapped(() => onOpenFile(hit.path)),
      }));
    }

    const actionItems: PaletteItem[] = [
      {
        id: "action:new-session",
        section: "Actions",
        label: "New session",
        hint: "⌘N",
        keywords: "new session claude start",
        icon: <Play size={13} />,
        run: wrapped(onNewSession),
      },
      {
        id: "action:open-folder",
        section: "Actions",
        label: "Open folder session…",
        keywords: "open folder project directory session",
        icon: <FolderOpen size={13} />,
        run: wrapped(onOpenFolderDialog),
      },
      ...extraCommands.map((command): PaletteItem => ({
        id: `action:${command.id}`,
        section: "Actions",
        label: command.label,
        hint: command.hint,
        keywords: command.keywords ?? command.label.toLowerCase(),
        icon: command.icon,
        run: wrapped(command.run),
      })),
    ];

    const tabItems: PaletteItem[] = tabs
      .filter((tab) => tab.id !== activeTabId)
      .map((tab) => ({
        id: `tab:${tab.id}`,
        section: "Tabs",
        label: tab.label,
        hint: compactHint(tab.cwd),
        keywords: `${tab.label} ${tab.cwd} switch tab`,
        icon: <SquareTerminal size={13} />,
        run: wrapped(() => onSelectTab(tab.id)),
      }));

    const folderItems: PaletteItem[] = recentFolders.map((folder) => ({
      id: `folder:${folder}`,
      section: "Recent folders",
      label: folder.split("/").filter(Boolean).pop() ?? folder,
      hint: compactHint(folder),
      keywords: `${folder} recent folder open`,
      icon: <History size={13} />,
      run: wrapped(() => onOpenRecentFolder(folder)),
    }));

    const skillItems: PaletteItem[] = skills.map((skill) => ({
      id: `skill:${skill.name}`,
      section: "Skills",
      label: skill.name,
      hint: skill.description,
      keywords: `${skill.name} skill ${skill.description ?? ""}`,
      icon: <Sparkles size={13} />,
      run: wrapped(() => onActivateSkill(skill.name)),
    }));

    return [...actionItems, ...tabItems, ...folderItems, ...skillItems, ...fileItems];
  }, [
    activeTabId,
    extraCommands,
    files,
    mode,
    onActivateSkill,
    onClose,
    onNewSession,
    onOpenFile,
    onOpenFolderDialog,
    onOpenRecentFolder,
    onSelectTab,
    recentFolders,
    searchHits,
    skills,
    tabs,
  ]);

  const results = useMemo(() => {
    // Search results are already ranked by the backend; fuzzy re-scoring
    // against the query would just shuffle them.
    if (mode === "search") return items.slice(0, 50);

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      // Without a query, files are noise in "all" mode; show curated sections.
      const base = mode === "files" ? items : items.filter((item) => item.section !== "Files");
      return base.slice(0, MAX_RESULTS);
    }

    return items
      .map((item) => ({ item, score: fuzzyScore(trimmed, item.keywords.toLowerCase(), item.label.toLowerCase()) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.item);
  }, [items, mode, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length, query]);

  useEffect(() => {
    const selected = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(current + 1, results.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        results[selectedIndex]?.run();
      }
    },
    [onClose, results, selectedIndex],
  );

  if (!open) return null;

  let lastSection = "";

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-20"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/25" onMouseDown={onClose} />
      <div className="sogo-pop sogo-elevated-bg relative flex w-[560px] max-w-[calc(100%-48px)] flex-col overflow-hidden rounded-2xl border border-cc-border shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-cc-border/60 px-4">
          <Search size={14} className="shrink-0 text-cc-muted" />
          <input
            ref={inputRef}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-cc-foreground outline-none placeholder:text-cc-muted"
            placeholder={
              mode === "files"
                ? "Open file…"
                : mode === "search"
                  ? "Search in files…"
                  : "Type a command, tab, folder, skill, or file…"
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="rounded border border-cc-border px-1.5 py-0.5 font-mono text-[10px] text-cc-muted">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[380px] min-h-0 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-cc-muted">
              {mode === "files" && files === null
                ? "Indexing files…"
                : mode === "search"
                  ? searching
                    ? "Searching…"
                    : query.trim().length < 2
                      ? "Type at least two characters to search file contents."
                      : "No matches."
                  : "No matches."}
            </div>
          ) : (
            results.map((item, index) => {
              const showSection = item.section !== lastSection && !query.trim();
              lastSection = item.section;

              return (
                <div key={item.id}>
                  {showSection ? (
                    <div className="px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-wide text-cc-muted/60">
                      {item.section}
                    </div>
                  ) : null}
                  <button
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-colors duration-100 ${
                      index === selectedIndex
                        ? "bg-cc-surface-strong text-cc-foreground"
                        : "text-cc-muted hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
                    }`}
                    onClick={() => item.run()}
                    onMouseMove={() => setSelectedIndex(index)}
                  >
                    <span className="shrink-0 text-cc-muted">{item.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-cc-muted/60">
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function compactHint(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Subsequence fuzzy match. Word-start and consecutive-run bonuses; substring
 * matches on the label rank highest.
 */
function fuzzyScore(query: string, keywords: string, label: string): number {
  if (label.includes(query)) return 1000 - label.indexOf(query) - label.length * 0.01;
  if (keywords.includes(query)) return 500 - keywords.indexOf(query) * 0.1;

  let score = 0;
  let queryIndex = 0;
  let lastMatch = -2;

  for (let index = 0; index < keywords.length && queryIndex < query.length; index += 1) {
    if (keywords[index] === query[queryIndex]) {
      score += 1;
      if (index === lastMatch + 1) score += 2;
      if (index === 0 || keywords[index - 1] === " " || keywords[index - 1] === "/" || keywords[index - 1] === "-") {
        score += 3;
      }
      lastMatch = index;
      queryIndex += 1;
    }
  }

  return queryIndex === query.length ? score : 0;
}

export const paletteIcons = {
  window: <AppWindow size={13} />,
  pin: <Pin size={13} />,
  theme: <Palette size={13} />,
  resume: <RefreshCw size={13} />,
};
