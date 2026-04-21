import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. Safe to call from React Client Components.
 * Uses the anon key; all data access is constrained by RLS policies.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
