import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

import { useVaultStore, type VaultDocument } from "@/stores/vaultStore";

interface TreeNode {
  key: string;
  label: string;
  path: string;
  children: TreeNode[];
  isLeaf: boolean;
}

interface VaultPanelProps {
  onOpenDocument: (sourcePath: string) => void;
  activePath?: string | null;
}

export function VaultPanel({ onOpenDocument, activePath }: VaultPanelProps) {
  const localFiles = useVaultStore((state) => state.localFiles);
  const documents = useVaultStore((state) => state.documents);
  const loading = useVaultStore((state) => state.loading);
  const error = useVaultStore((state) => state.error);
  const remoteDegraded = useVaultStore((state) => state.remoteDegraded);
  const loadedOnce = useVaultStore((state) => state.loadedOnce);
  const refresh = useVaultStore((state) => state.refresh);

  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const preFilterExpanded = useRef<Set<string> | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  // Cached data appears instantly on reopen; refresh in the background.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const titleByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const document of documents) {
      if (!document.source_path || !document.title) continue;
      map.set(displayPathForDocument(document.source_path), document.title);
    }
    return map;
  }, [documents]);

  // Local files are the source of truth; Supabase rows fill gaps when no
  // local vault exists (e.g. browser dev) and decorate titles otherwise.
  const allPaths = useMemo(() => {
    if (localFiles && localFiles.length > 0) return localFiles;
    return [...titleByPath.keys()].sort();
  }, [localFiles, titleByPath]);

  const visiblePaths = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return allPaths;
    return allPaths.filter((path) => {
      if (path.toLowerCase().includes(query)) return true;
      const title = titleByPath.get(path);
      return !!title && title.toLowerCase().includes(query);
    });
  }, [allPaths, filter, titleByPath]);

  const tree = useMemo(() => buildTree(visiblePaths, titleByPath), [visiblePaths, titleByPath]);

  // Filtering force-expands the matching tree; snapshot the user's expansion
  // first and restore it when the filter clears.
  useEffect(() => {
    if (filter.trim()) {
      preFilterExpanded.current ??= new Set(expanded);
      setExpanded(new Set(collectFolderKeys(tree)));
    } else if (preFilterExpanded.current) {
      setExpanded(preFilterExpanded.current);
      preFilterExpanded.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, tree]);

  const handleKeyNav = useCallback((event: React.KeyboardEvent, node: TreeNode) => {
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const rows = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[data-sogo-vault-row]") ?? [],
    );
    const index = rows.indexOf(event.currentTarget as HTMLElement);
    if (index < 0) return;

    if (event.key === "ArrowDown") {
      rows[index + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      rows[index - 1]?.focus();
    } else if (event.key === "ArrowRight") {
      if (!node.isLeaf && !expanded.has(node.key)) {
        setExpanded((current) => new Set(current).add(node.key));
      } else {
        rows[index + 1]?.focus();
      }
    } else if (event.key === "ArrowLeft") {
      if (!node.isLeaf && expanded.has(node.key)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(node.key);
          return next;
        });
      } else {
        const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : null;
        if (parent) rows.find((row) => row.dataset.sogoVaultPath === parent)?.focus();
      }
    }
  }, [expanded]);

  return (
    <section ref={panelRef} className="flex min-h-0 flex-1 shrink flex-col">
      <div className="flex h-10 items-center justify-between px-3">
        <h2 className="text-sm font-semibold">GenZen OS</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-cc-muted">{visiblePaths.length}</span>
          <button
            className="rounded p-0.5 text-cc-muted transition-colors hover:text-cc-foreground"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh GenZen OS documents"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <div className="p-2">
        <input
          className="h-8 w-full rounded-md border border-cc-border bg-cc-background px-2 text-xs text-cc-foreground outline-none placeholder:text-cc-muted transition-colors duration-150 focus:border-cc-accent/40 focus:ring-1 focus:ring-cc-accent/30"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter GenZen OS"
        />
      </div>
      {remoteDegraded && !error ? (
        <div className="mx-2 mb-1 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200/90">
          Supabase unreachable — showing local vault only.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loadedOnce && loading ? (
          <div className="p-2 text-xs text-cc-muted">Loading GenZen OS...</div>
        ) : error ? (
          <div className="space-y-2 rounded-md border border-cc-border bg-cc-background/50 p-3 text-xs text-cc-muted">
            <div>{error}</div>
            <button
              className="rounded-md border border-cc-border px-2 py-1 text-[11px] text-cc-foreground/90 transition-colors hover:bg-cc-surface-strong"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        ) : tree.length === 0 ? (
          <div className="p-2 text-xs text-cc-muted">
            {filter.trim() ? "No matching documents." : "No GenZen OS documents loaded."}
          </div>
        ) : (
          <Tree
            nodes={tree}
            expanded={expanded}
            activePath={activePath}
            onToggle={(key) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onSelect={(node) => onOpenDocument(node.path)}
            onKeyNav={handleKeyNav}
          />
        )}
      </div>
    </section>
  );
}

function buildTree(paths: string[], titleByPath: Map<string, string>): TreeNode[] {
  const root: TreeNode[] = [];

  for (const fullPath of paths) {
    const parts = fullPath.split("/").filter(Boolean);
    let level = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      // Match on leaf-ness too: a folder and a file can share a name.
      let node = level.find((candidate) => candidate.label === part && candidate.isLeaf === isLeaf);

      if (!node) {
        node = {
          key: currentPath + (isLeaf ? ":file" : ""),
          label: isLeaf ? titleByPath.get(fullPath) || stripExtension(part) : part,
          path: currentPath,
          children: [],
          isLeaf,
        };
        level.push(node);
      }

      level = node.children;
    });
  }

  return sortTree(root);
}

function stripExtension(name: string) {
  return name.replace(/\.(md|mdx|markdown)$/i, "");
}

function displayPathForDocument(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const vaultMarker = "/vault/";
  const vaultIndex = normalized.indexOf(vaultMarker);
  if (vaultIndex >= 0) return normalized.slice(vaultIndex + vaultMarker.length);

  const obsidianMarker = "/Documents/Obsidian/";
  const obsidianIndex = normalized.indexOf(obsidianMarker);
  if (obsidianIndex >= 0) return normalized.slice(obsidianIndex + obsidianMarker.length);

  return normalized.replace(/^\/Users\/[^/]+\//, "");
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .sort((a, b) => {
      if (!a.isLeaf && b.isLeaf) return -1;
      if (a.isLeaf && !b.isLeaf) return 1;
      return a.label.localeCompare(b.label);
    })
    .map((node) => ({ ...node, children: sortTree(node.children) }));
}

function collectFolderKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.isLeaf ? [] : [node.key]),
    ...collectFolderKeys(node.children),
  ]);
}

function Tree({
  nodes,
  expanded,
  activePath,
  onToggle,
  onSelect,
  onKeyNav,
  depth = 0,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  activePath?: string | null;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
  onKeyNav: (event: React.KeyboardEvent, node: TreeNode) => void;
  depth?: number;
}) {
  return (
    <div className={depth === 0 ? "space-y-0.5" : ""}>
      {nodes.map((node) => (
        <TreeNodeView
          key={node.key}
          node={node}
          depth={depth}
          expanded={expanded}
          activePath={activePath}
          onToggle={onToggle}
          onSelect={onSelect}
          onKeyNav={onKeyNav}
        />
      ))}
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  expanded,
  activePath,
  onToggle,
  onSelect,
  onKeyNav,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath?: string | null;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
  onKeyNav: (event: React.KeyboardEvent, node: TreeNode) => void;
}) {
  const isExpanded = expanded.has(node.key);
  const isActive = node.isLeaf && !!activePath
    && (activePath === node.path || activePath.endsWith(`/${node.path}`));

  return (
    <div>
      <button
        className={`flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
          isActive ? "bg-cc-surface-strong" : ""
        }`}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-sogo-vault-row="true"
        data-sogo-vault-path={node.path}
        onClick={() => {
          if (!node.isLeaf) onToggle(node.key);
          else onSelect(node);
        }}
        onKeyDown={(event) => onKeyNav(event, node)}
      >
        {!node.isLeaf ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-cc-muted/70 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={`truncate ${isActive ? "text-cc-foreground" : !node.isLeaf ? "text-cc-foreground/90" : "text-cc-muted"}`}
        >
          {node.label}
        </span>
      </button>
      {!node.isLeaf && isExpanded ? (
        <Tree
          nodes={node.children}
          expanded={expanded}
          activePath={activePath}
          onToggle={onToggle}
          onSelect={onSelect}
          onKeyNav={onKeyNav}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}
