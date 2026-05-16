import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import type { ClaudeInventory } from "@/types";

interface SkillsPanelProps {
  onActivateSkill: (skillName: string) => void;
}

export function SkillsPanel({ onActivateSkill }: SkillsPanelProps) {
  const [inventory, setInventory] = useState<ClaudeInventory>({ skills: [], mcpServers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInventory = useCallback(() => {
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke<ClaudeInventory>("read_claude_inventory")
        .then((nextInventory) => {
          setInventory(nextInventory);
          setError(null);
        })
        .catch((readError) => {
          setInventory({ skills: [], mcpServers: [] });
          setError(String(readError));
        })
        .finally(() => setLoading(false));
    });
  }, []);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-cc-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-cc-border px-3">
        <div>
          <h2 className="text-sm font-semibold">Claude inventory</h2>
          <div className="text-[11px] text-cc-muted">Installed skills and MCP servers</div>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
          onClick={loadInventory}
          title="Refresh Claude inventory"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {error ? <div className="m-3 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-100">{error}</div> : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-cc-foreground">Skills</span>
            <span className="text-cc-muted">{inventory.skills.length}</span>
          </div>
          <div className="space-y-1.5">
            {inventory.skills.length === 0 ? (
              <div className="rounded-md border border-cc-border bg-cc-background/40 p-3 text-xs leading-5 text-cc-muted">
                {loading ? "Loading skills..." : "No installed skills found."}
              </div>
            ) : (
              inventory.skills.map((skill) => (
                <button
                  key={skill.path}
                  type="button"
                  className="block w-full rounded-md border border-cc-border bg-cc-background/40 p-2 text-left transition hover:border-cc-accent/60 hover:bg-cc-surface-strong focus:outline-none focus:ring-1 focus:ring-cc-accent"
                  onClick={() => onActivateSkill(skill.name)}
                  title={`Use ${skill.name}`}
                >
                  <div className="truncate text-xs font-medium text-cc-foreground">{skill.name}</div>
                  {skill.description ? (
                    <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-cc-muted">
                      {skill.description}
                    </div>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-cc-foreground">MCP servers</span>
            <span className="text-cc-muted">{inventory.mcpServers.length}</span>
          </div>
          <div className="space-y-1.5">
            {inventory.mcpServers.length === 0 ? (
              <div className="rounded-md border border-cc-border bg-cc-background/40 p-3 text-xs leading-5 text-cc-muted">
                {loading ? "Loading MCP servers..." : "No MCP servers found."}
              </div>
            ) : (
              inventory.mcpServers.map((server) => (
                <div key={server.name} className="flex items-center justify-between rounded-md border border-cc-border bg-cc-background/40 px-2 py-1.5 text-xs">
                  <span className="truncate text-cc-foreground">{server.name}</span>
                  <span className="ml-2 shrink-0 rounded border border-cc-border px-1.5 py-0.5 text-[10px] text-cc-muted">{server.status}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
