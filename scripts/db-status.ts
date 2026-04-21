import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = postgres(url, { max: 1 });

  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `;

  const enums = await sql<{ typname: string }[]>`
    SELECT typname FROM pg_type
    WHERE typtype = 'e' AND typnamespace = (
      SELECT oid FROM pg_namespace WHERE nspname = 'public'
    )
    ORDER BY typname
  `;

  console.log("Tables in public schema:");
  tables.forEach((r) => console.log("  -", r.tablename));
  console.log("Enums in public schema:");
  enums.forEach((r) => console.log("  -", r.typname));

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
