/**
 * End-to-end verification of master-data CRUD: customers and vendors.
 * Validates tenant isolation (code uniqueness per org) and 1099 handling.
 *
 *   npx tsx scripts/test-parties.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  customers,
  memberships,
  organizations,
  profiles,
  vendors,
} from "../src/lib/db/schema";
import { deleteFixtures, testWorkspace } from "./lib/workspace";

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
    await deleteFixtures(tx, "parties-test-");
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const [org] = await db
    .insert(organizations)
    .values({ workspaceId: await testWorkspace(db, testSlug), name: "Parties Test", slug: testSlug, baseCurrency: "USD" })
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

  console.log("\nTenant isolation");
  await check("second org can reuse the same customer code", async () => {
    const [org2] = await db
      .insert(organizations)
      .values({
        workspaceId: await testWorkspace(db, testSlug + "-b"),
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
