import { create } from "zustand";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createRuntimeSupabaseClient } from "@/lib/supabase";
import { isTauriRuntime } from "@/lib/runtime";
import type { RuntimeConfig } from "@/types";

export interface VaultDocument {
  id: string | number;
  title: string | null;
  source_path: string | null;
  document_type?: string | null;
  domain?: string | null;
}

interface VaultState {
  /** Relative markdown paths under the local vault roots — source of truth. */
  localFiles: string[] | null;
  /** Supabase metadata, used to decorate local files with titles. */
  documents: VaultDocument[];
  loading: boolean;
  /** Fatal only when both local listing and Supabase failed. */
  error: string | null;
  /** Non-fatal: local tree is fine but Supabase metadata is unavailable. */
  remoteDegraded: boolean;
  loadedOnce: boolean;
  refresh: () => Promise<void>;
}

/**
 * Singleton Supabase client + realtime channel, kept for the app's lifetime.
 * The vault panel unmounts on every close; recreating the client and channel
 * each open meant a cold fetch and a resubscribe every time.
 */
let client: SupabaseClient | null = null;
let started = false;

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!isTauriRuntime()) return {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RuntimeConfig>("read_runtime_config");
  } catch {
    return {};
  }
}

async function loadLocalFiles(): Promise<string[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("list_vault_files");
  } catch {
    return null;
  }
}

async function loadDocuments(): Promise<VaultDocument[] | null> {
  if (!client) return null;
  const { data, error } = await client
    .schema("knowledge")
    .from("documents")
    .select("id,title,source_path,document_type,domain")
    .order("source_path", { ascending: true });
  if (error) return null;
  return data ?? [];
}

export const useVaultStore = create<VaultState>((set, get) => ({
  localFiles: null,
  documents: [],
  loading: false,
  error: null,
  remoteDegraded: false,
  loadedOnce: false,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });

    if (!started) {
      started = true;
      const config = await loadRuntimeConfig();
      client = createRuntimeSupabaseClient(config);
      if (client) {
        client
          .channel("sogo-vault-documents")
          // The documents table lives in the "knowledge" schema — subscribing
          // to "public" never fires.
          .on("postgres_changes", { event: "*", schema: "knowledge", table: "documents" }, () => {
            void get().refresh();
          })
          .subscribe();
      }
    }

    const [localFiles, documents] = await Promise.all([loadLocalFiles(), loadDocuments()]);

    const nothingAvailable = localFiles === null && documents === null;
    set({
      localFiles,
      documents: documents ?? get().documents,
      remoteDegraded: documents === null && !!client,
      error: nothingAvailable
        ? "No local vault found and Supabase is unreachable."
        : null,
      loading: false,
      loadedOnce: true,
    });
  },
}));
