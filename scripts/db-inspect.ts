import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = postgres(url, { max: 1 });

  const migrations = await sql<{ hash: string; created_at: bigint }[]>`
    SELECT hash, created_at
      FROM drizzle.__drizzle_migrations
     ORDER BY id
  `.catch(() => [] as { hash: string; created_at: bigint }[]);

  const functions = await sql<{ proname: string }[]>`
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('handle_new_user', 'handle_user_email_change', 'is_member_of')
    ORDER BY proname
  `;

  const triggers = await sql<{ tgname: string; tgrelid: string }[]>`
    SELECT t.tgname, c.relname AS tgrelid
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
     WHERE t.tgname IN ('on_auth_user_created', 'on_auth_user_updated')
     ORDER BY t.tgname
  `;

  const rlsTables = await sql<{ tablename: string; rls: boolean }[]>`
    SELECT tablename, rowsecurity AS rls
      FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename
  `;

  console.log("Applied migrations:");
  migrations.forEach((r) => console.log("  -", r.hash));
  console.log("Functions present:");
  functions.forEach((r) => console.log("  -", r.proname));
  console.log("Triggers present:");
  triggers.forEach((r) => console.log("  -", r.tgname, "on", r.tgrelid));
  console.log("RLS status:");
  rlsTables.forEach((r) =>
    console.log("  -", r.tablename, r.rls ? "[RLS ON]" : "[RLS OFF]")
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
