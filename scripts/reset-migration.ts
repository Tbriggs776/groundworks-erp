/**
 * One-shot repair: if a migration was accidentally applied with empty content
 * (e.g., file wasn't saved before `npm run db:migrate` ran), delete that row
 * from drizzle.__drizzle_migrations so the next migrate re-applies the real
 * content. Targeted by index (idx) — adjust ARG before running.
 *
 *   npx tsx scripts/reset-migration.ts 1
 *
 * Idempotent: deleting a non-existent row is a no-op.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import postgres from "postgres";

async function main() {
  const idx = Number(process.argv[2]);
  if (!Number.isInteger(idx)) {
    console.error("Usage: tsx scripts/reset-migration.ts <idx>");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = postgres(url, { max: 1 });

  // drizzle.__drizzle_migrations rows are ordered by id (serial) — the
  // journal idx corresponds to id starting at 1. Delete by id > 0.
  const before = await sql<{ id: number; hash: string }[]>`
    SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id
  `;
  console.log("Before:", before);

  // idx in journal is 0-based, __drizzle_migrations.id is 1-based (serial).
  const targetId = idx + 1;
  const deleted = await sql`
    DELETE FROM drizzle.__drizzle_migrations WHERE id = ${targetId}
    RETURNING id, hash
  `;
  console.log("Deleted:", deleted);

  const after = await sql<{ id: number; hash: string }[]>`
    SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id
  `;
  console.log("After:", after);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
