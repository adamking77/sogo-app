import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChevronRight } from "lucide-react";

import { createRuntimeSupabaseClient } from "@/lib/supabase";
import { isTauriRuntime } from "@/lib/runtime";
import type { RuntimeConfig } from "@/types";

interface VaultDocument {
  id: string | number;
  title: string | null;
  source_path: string | null;
  document_type?: string | null;
  domain?: string | null;
}

interface TreeNode {
  key: string;
  label: string;
  path: string;
  children: TreeNode[];
  document?: VaultDocument;
}

interface VaultPanelProps {
  onOpenDocument: (sourcePath: string) => void;
  activePath?: string | null;
}

export function VaultPanel({ onOpenDocument, activePath }: VaultPanelProps) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!isTauriRuntime()) {
      setConfig({});
      return;
    }

    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<RuntimeConfig>("read_runtime_config")
        .then(setConfig)
        .catch(() => setConfig({}));
    });
  }, []);

  useEffect(() => {
    if (!config) return;

    const client = createRuntimeSupabaseClient(config);
    if (!client) {
      setError("Supabase runtime config is missing.");
      return;
    }

    setError(null);
    void loadDocuments(client, setDocuments, setError);

    // The documents table lives in the "knowledge" schema — subscribing to
    // "public" never fires.
    const channel = client
      .channel("sogo-vault-documents")
      .on("postgres_changes", { event: "*", schema: "knowledge", table: "documents" }, () => {
        void loadDocuments(client, setDocuments, setError);
      })
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [config]);

  const visibleDocuments = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return documents;

    return documents.filter((document) => {
      return [document.title, document.source_path, document.document_type, document.domain]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [documents, filter]);
  const tree = useMemo(() => buildTree(visibleDocuments), [visibleDocuments]);

  useEffect(() => {
    if (filter.trim()) {
      setExpanded(new Set(collectFolderKeys(tree)));
    }
  }, [filter, tree]);

  return (
    <section className="flex min-h-0 flex-1 shrink flex-col">
      <div className="flex h-10 items-center justify-between px-3">
        <h2 className="text-sm font-semibold">GenZen OS</h2>
        <span className="text-[11px] tabular-nums text-cc-muted">{visibleDocuments.length}</span>
      </div>
      <div className="p-2">
        <input
          className="h-8 w-full rounded-md border border-cc-border bg-cc-background px-2 text-xs text-cc-foreground outline-none placeholder:text-cc-muted transition-colors duration-150 focus:border-cc-accent/40 focus:ring-1 focus:ring-cc-accent/30"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter GenZen OS"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!config ? (
          <div className="p-2 text-xs text-cc-muted">Loading GenZen OS...</div>
        ) : error ? (
          <div className="rounded-md border border-cc-border bg-cc-background/50 p-3 text-xs text-cc-muted">
            {error}
          </div>
        ) : (
          <Tree
            nodes={tree}
            expanded={expanded}
            activeSourcePath={activePath}
            onToggle={(key) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onSelect={(document) => {
              if (document.source_path) onOpenDocument(document.source_path);
            }}
          />
        )}
      </div>
    </section>
  );
}

async function loadDocuments(
  client: SupabaseClient,
  setDocuments: (documents: VaultDocument[]) => void,
  setError: (error: string | null) => void,
) {
  const { data, error } = await client
    .schema("knowledge")
    .from("documents")
    .select("id,title,source_path,document_type,domain")
    .order("source_path", { ascending: true });

  if (error) {
    setError(error.message);
    return;
  }

  setError(null);
  setDocuments(data ?? []);
}

function buildTree(documents: VaultDocument[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const document of documents) {
    const path = document.source_path?.trim();
    if (!path) continue;

    const parts: string[] = displayPathForDocument(path).split("/").filter(Boolean);
    let level = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      let node = level.find((candidate) => candidate.label === part);

      if (!node) {
        node = {
          key: isLeaf ? `${currentPath}:${document.id}` : currentPath,
          label: isLeaf ? document.title || part : part,
          path: currentPath,
          children: [],
          document: isLeaf ? document : undefined,
        };
        level.push(node);
      }

      if (isLeaf) {
        node.label = document.title || part;
        node.document = document;
      }

      level = node.children;
    });
  }

  return sortTree(root);
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
      if (a.children.length && !b.children.length) return -1;
      if (!a.children.length && b.children.length) return 1;
      return a.label.localeCompare(b.label);
    })
    .map((node) => ({ ...node, children: sortTree(node.children) }));
}

function collectFolderKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.children.length > 0 ? [node.key] : []),
    ...collectFolderKeys(node.children),
  ]);
}

function Tree({
  nodes,
  expanded,
  activeSourcePath,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  activeSourcePath?: string | null;
  onToggle: (key: string) => void;
  onSelect: (document: VaultDocument) => void;
}) {
  if (nodes.length === 0) {
    return <div className="p-2 text-xs text-cc-muted">No GenZen OS documents loaded.</div>;
  }

  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNodeView
          key={node.key}
          node={node}
          depth={0}
          expanded={expanded}
          activeSourcePath={activeSourcePath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  expanded,
  activeSourcePath,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activeSourcePath?: string | null;
  onToggle: (key: string) => void;
  onSelect: (document: VaultDocument) => void;
}) {
  const isFolder = node.children.length > 0;
  const isExpanded = expanded.has(node.key);
  const isActive = !isFolder && !!node.document?.source_path && !!activeSourcePath
    && (activeSourcePath === node.document.source_path || activeSourcePath.endsWith(`/${node.document.source_path}`));

  return (
    <div>
      <button
        className={`flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-xs transition-colors duration-150 hover:bg-cc-surface-strong ${
          isActive ? "bg-cc-surface-strong" : ""
        }`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (isFolder) onToggle(node.key);
          else if (node.document) onSelect(node.document);
        }}
      >
        {isFolder ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-cc-muted/70 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={`truncate ${isActive ? "text-cc-foreground" : isFolder ? "text-cc-foreground/90" : "text-cc-muted"}`}
        >
          {node.label}
        </span>
      </button>
      {isFolder && isExpanded
        ? node.children.map((child) => (
            <TreeNodeView
              key={child.key}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeSourcePath={activeSourcePath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}
