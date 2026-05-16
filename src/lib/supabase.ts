import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "@/types";

export function createRuntimeSupabaseClient(config: RuntimeConfig): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }

  return createClient(config.supabaseUrl, config.supabaseAnonKey);
}
