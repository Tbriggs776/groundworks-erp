import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Runtime DB client — LAZY.
 *
 * The exported `db` is a Proxy that defers the real postgres() + drizzle()
 * initialization until the first property access. Reasons:
 *
 *   1. Next.js "Collecting page data" imports every module transitively to
 *      trace dependencies. Without lazy init, an environment missing
 *      DATABASE_URL / POSTGRES_URL at build time (e.g., a fresh Vercel
 *      project before the Supabase integration lands) throws on module
 *      import and hangs the build.
 *
 *   2. Standalone scripts via `tsx` don't get `.env.local` loaded for free.
 *      Lazy init lets us pull dotenv the first time someone actually queries.
 *
 *   3. Cold-start overhead: serverless functions only pay the postgres()
 *      connect cost when they use the DB, not on every warm-up.
 *
 * API is unchanged — callers keep using `db.select(...).from(...)`.
 */

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
type PostgresClient = ReturnType<typeof postgres>;

let _db: DrizzleDB | null = null;
let _client: PostgresClient | null = null;

function initDb(): DrizzleDB {
  if (_db) return _db;

  // Standalone scripts (tsx/node) — load .env.local if neither var is set.
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dotenv = require("dotenv") as typeof import("dotenv");
      dotenv.config({ path: ".env.local" });
      dotenv.config({ path: ".env" });
    } catch {
      // dotenv isn't a runtime dep on Vercel; missing is fine.
    }
  }

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "Neither DATABASE_URL nor POSTGRES_URL is set. In production this " +
        "should be the Supabase pooled connection string (transaction mode). " +
        "See .env.example."
    );
  }

  _client = postgres(connectionString, { prepare: false });
  _db = drizzle(_client, { schema, casing: "snake_case" });
  return _db;
}

/**
 * Proxy forwards every property access to the real drizzle instance. The
 * real instance is created on the first access (build-time imports never
 * trigger it since they don't call any methods).
 */
export const db = new Proxy({} as DrizzleDB, {
  get(_target, prop, receiver) {
    const real = initDb();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export type DB = DrizzleDB;
export { schema };

// Drizzle's $client property flows through the proxy automatically; scripts
// can still call `await db.$client.end()` to close the pool.
