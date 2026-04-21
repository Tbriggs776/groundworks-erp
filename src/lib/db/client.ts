import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. In production this should be the Supabase " +
      "pooled connection string (transaction mode). See .env.example."
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
