import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/*
 * Connection string resolution:
 *   1. DATABASE_URL — our canonical name, used locally via .env.local
 *   2. POSTGRES_URL — auto-provisioned by Vercel's Supabase integration
 *                     (already points at the pooled connection)
 * Either should be the TRANSACTION POOLER URL (port 6543) in serverless
 * environments. A direct connection works for long-lived dev processes but
 * exhausts under Vercel's per-request connection model.
 */
const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error(
    "Neither DATABASE_URL nor POSTGRES_URL is set. In production this " +
      "should be the Supabase pooled connection string (transaction mode). " +
      "See .env.example."
  );
}

/**
 * Runtime DB client. Uses a pooled Supabase connection so it's safe from
 * serverless (Vercel) functions.
 *
 *   - `prepare: false` is required for Supabase transaction-mode pooling
 *   - Drizzle `casing: "snake_case"` mirrors the drizzle.config.ts setting
 */
const queryClient = postgres(connectionString, { prepare: false });

export const db = drizzle(queryClient, { schema, casing: "snake_case" });
export type DB = typeof db;
export { schema };
