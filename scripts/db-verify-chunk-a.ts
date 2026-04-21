import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = postgres(url, { max: 1 });

  const currencies = await sql<{ code: string; name: string }[]>`
    SELECT code, name FROM public.currencies ORDER BY code
  `;

  const orgCols = await sql<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
     ORDER BY ordinal_position
  `;

  const enums = await sql<{ typname: string; values: string[] }[]>`
    SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typnamespace = 'public'::regnamespace
       AND t.typname IN ('period_status', 'account_type', 'account_subcategory')
     GROUP BY t.typname
     ORDER BY t.typname
  `;

  console.log(`Currencies seeded: ${currencies.length}`);
  currencies.forEach((c) => console.log(`  - ${c.code}: ${c.name}`));

  console.log(`\nOrganizations columns:`);
  orgCols.forEach((c) => console.log(`  - ${c.column_name.padEnd(40)} ${c.data_type}`));

  console.log(`\nKey enums:`);
  enums.forEach((e) =>
    console.log(`  - ${e.typname}: ${e.values.join(", ")}`)
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
