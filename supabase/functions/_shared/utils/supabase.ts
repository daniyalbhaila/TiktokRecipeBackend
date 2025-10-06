import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Get Supabase client with service role key
 * Throws error if credentials are missing
 */
export function getSupabaseClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Missing Supabase credentials");
  }

  return createClient(url, key);
}

/**
 * Get environment variable or throw error
 */
export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
