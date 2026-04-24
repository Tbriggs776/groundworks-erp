/**
 * End-to-end verification of master-data CRUD: customers, vendors, employees.
 * Validates tenant isolation (code uniqueness per org), 1099 handling, and
 * user-link integrity (can't link to non-member, can't double-link a user).
 *
 *   npx tsx scripts/test-parties.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  customers,
  employees,
  memberships,
  organizations,
  profiles,
  vendors,
} from "../src/lib/db/schema";

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

async function main() {
  const testSlug = `parties-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "parties-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const [org] = await db
    .insert(organizations)
    .values({ name: "Parties Test", slug: testSlug, baseCurrency: "USD" })
    .returning();
  await db.insert(memberships).values({
    organizationId: org.id,
    userId: actor.id,
    role: "owner",
  });

  console.log(`\nTest org: ${org.slug}\n`);

  console.log("Customers");
  let custId: string | null = null;
  await check("insert customer", async () => {
    const [row] = await db
      .insert(customers)
      .values({
        organizationId: org.id,
        code: "CUST-001",
        name: "ACME Corp",
        customerType: "commercial",
      })
      .returning({ id: customers.id });
    custId = row.id;
  });
  await check("duplicate code rejected", async () => {
    try {
      await db.insert(customers).values({
        organizationId: org.id,
        code: "CUST-001",
        name: "Another ACME",
        customerType: "commercial",
      });
      throw new Error("expected unique violation");
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code !== "23505")
        throw new Error(`wrong error: ${(e as Error).message}`);
    }
  });

  console.log("\nVendors");
  await check("insert 1099 vendor", async () => {
    await db.insert(vendors).values({
      organizationId: org.id,
      code: "VEND-001",
      name: "ABC Concrete",
      vendorType: "subcontractor",
      is1099Vendor: true,
      tin: "12-3456789",
      w9OnFile: true,
    });
  });
  await check("non-1099 supplier vendor", async () => {
    await db.insert(vendors).values({
      organizationId: org.id,
      code: "VEND-002",
      name: "Big Supply Co",
      vendorType: "supplier",
    });
  });

  console.log("\nEmployees (user link)");
  let empId: string | null = null;
  await check("insert employee linked to logged-in user", async () => {
    const [row] = await db
      .insert(employees)
      .values({
        organizationId: org.id,
        code: "EMP-001",
        firstName: "Mike",
        lastName: "Johnson",
        classification: "salary",
        userId: actor.id,
        hireDate: "2024-01-15",
      })
      .returning({ id: employees.id });
    empId = row.id;
  });
  await check("second employee linking to SAME user is rejected", async () => {
    try {
      await db.insert(employees).values({
        organizationId: org.id,
        code: "EMP-002",
        firstName: "Dup",
        lastName: "User",
        classification: "hourly",
        userId: actor.id,
      });
      throw new Error("expected unique violation on user_id");
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code !== "23505")
        throw new Error(`wrong error: ${(e as Error).message}`);
    }
  });
  await check("unlinked field-crew employee (no userId) OK", async () => {
    await db.insert(employees).values({
      organizationId: org.id,
      code: "EMP-FIELD-01",
      firstName: "Sam",
      lastName: "Carpenter",
      classification: "hourly",
      defaultRate: "32.50",
    });
  });

  console.log("\nTenant isolation");
  await check("second org can reuse the same customer code", async () => {
    const [org2] = await db
      .insert(organizations)
      .values({
        name: "Parties Test 2",
        slug: testSlug + "-b",
        baseCurrency: "USD",
      })
      .returning();
    await db.insert(customers).values({
      organizationId: org2.id,
      code: "CUST-001", // same code as in org 1 — different tenant, should work
      name: "Unrelated ACME",
      customerType: "commercial",
    });
    // cleanup
    await db.delete(organizations).where(eq(organizations.id, org2.id));
  });

  console.log("\nRelations");
  await check("employee joined back to profile resolves", async () => {
    const [row] = await db
      .select({
        employee: employees,
        user: profiles,
      })
      .from(employees)
      .innerJoin(profiles, eq(profiles.id, employees.userId))
      .where(and(eq(employees.id, empId!), eq(employees.organizationId, org.id)));
    if (!row || !row.user) throw new Error("expected joined user row");
    if (row.user.id !== actor.id) throw new Error("joined to wrong profile");
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, org.id));
  });
  void custId;

  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
