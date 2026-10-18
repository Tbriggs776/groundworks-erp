/**
 * Row-level security is the safety net under Supabase's auto-generated REST
 * API: anything reachable with the public anon key must be filtered by RLS.
 * This suite fails if a public table ships without RLS, and proves the
 * member-only SELECT policies actually filter rows.
 *
 *   npx tsx scripts/test-rls.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  agents,
  apiKeys,
  memberships,
  organizations,
  profiles,
} from "../src/lib/db/schema";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ${PASS} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL} ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}

/** Count rows of `table` visible to `role`, optionally as a signed-in user. */
async function visibleCount(
  table: string,
  role: "anon" | "authenticated",
  userId?: string
): Promise<number> {
  return db.transaction(async (tx) => {
    if (userId) {
      await tx.execute(
        sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`
      );
    }
    await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
    const [row] = await tx.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM public.${table}`)
    );
    return row.n;
  });
}

async function main() {
  const testSlug = `rls-test-${Date.now()}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "rls-test-%"));
  });

  const [member] = await db.select().from(profiles).limit(1);
  if (!member) throw new Error("No profiles. Run scripts/dev/reset-test-db.sh.");

  // A second, unrelated user.
  const [outsiderAuth] = await db.execute<{ id: string }>(
    sql`INSERT INTO auth.users (email) VALUES (${`outsider-${Date.now()}@example.com`}) RETURNING id`
  );

  const org = await db.transaction(async (tx) => {
    const [o] = await tx
      .insert(organizations)
      .values({ name: "RLS Test", slug: testSlug })
      .returning();
    await tx
      .insert(memberships)
      .values({ organizationId: o.id, userId: member.id, role: "owner" });
    await seedOrganizationDefaults(tx, o.id, { includeDefaultCoa: true });
    const [agent] = await tx
      .insert(agents)
      .values({ organizationId: o.id, name: "RLS bot", role: "bookkeeper" })
      .returning();
    await tx.insert(apiKeys).values({
      organizationId: o.id,
      agentId: agent.id,
      name: "rls",
      prefix: "gwk_rlstest0",
      secretHash: `rls-${Date.now()}`,
      scopes: ["read"],
    });
    return o;
  });

  console.log(`\nTest org: ${org.slug}\n`);

  await check("every public table has RLS enabled", async () => {
    const rows = await db.execute<{ relname: string }>(sql`
      SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relkind = 'r'
         AND NOT relrowsecurity
    `);
    if (rows.length > 0) {
      throw new Error(`RLS disabled on: ${rows.map((r) => r.relname).join(", ")}`);
    }
  });

  await check("anon sees no accounts", async () => {
    const n = await visibleCount("accounts", "anon");
    if (n !== 0) throw new Error(`anon saw ${n} accounts`);
  });

  await check("member sees their org's accounts", async () => {
    const n = await visibleCount("accounts", "authenticated", member.id);
    if (n === 0) throw new Error("member saw 0 accounts");
  });

  await check("outsider sees none of that org's accounts", async () => {
    const n = await visibleCount("accounts", "authenticated", outsiderAuth.id);
    if (n !== 0) throw new Error(`outsider saw ${n} accounts`);
  });

  await check("member sees agents in their org", async () => {
    const n = await visibleCount("agents", "authenticated", member.id);
    if (n === 0) throw new Error("member saw 0 agents");
  });

  await check("api_keys are invisible even to members", async () => {
    const n = await visibleCount("api_keys", "authenticated", member.id);
    if (n !== 0) throw new Error(`member saw ${n} api_keys rows`);
  });

  await check("anon cannot insert customers", async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE anon`);
        await tx.execute(sql`
          INSERT INTO public.customers (organization_id, code, name)
          VALUES (${org.id}, 'HAX', 'Should not exist')
        `);
      });
      throw new Error("insert succeeded");
    } catch (e) {
      if (!/row-level security/i.test((e as Error).message + String((e as { cause?: unknown }).cause))) {
        throw e;
      }
    }
  });

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, org.id));
  });
  await db.execute(sql`DELETE FROM auth.users WHERE id = ${outsiderAuth.id}`);

  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
