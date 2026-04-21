/**
 * Delete the most recent row from drizzle.__drizzle_migrations so the next
 * `npm run db:migrate` re-applies the last migration file. Useful when a
 * custom SQL migration was applied with empty content before being filled in.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = postgres(url, { max: 1 });
  const before = await sql<{ id: number; hash: string }[]>`
    SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id
  `;
  console.log("Before:");
  before.forEach((r) => console.log(`  id=${r.id}  ${r.hash.slice(0, 10)}`));

  const deleted = await sql<{ id: number }[]>`
    DELETE FROM drizzle.__drizzle_migrations
    WHERE id = (SELECT MAX(id) FROM drizzle.__drizzle_migrations)
    RETURNING id
  `;
  console.log(`Deleted id=${deleted[0]?.id}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
