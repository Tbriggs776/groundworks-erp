import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Applies all pending migrations in src/lib/db/migrations/ against the
 * database pointed to by DATABASE_URL_MIGRATE (falls back to DATABASE_URL).
 *
 * Non-interactive — safe for CI and for local dev. Idempotent: already-applied
 * migrations are skipped via drizzle's __drizzle_migrations tracking table.
 */
async function main() {
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL_MIGRATE (or DATABASE_URL) is not set. See .env.example."
    );
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });

  await sql.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
